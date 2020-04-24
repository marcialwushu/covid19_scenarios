import Ajv, { Ajv as AjvModule } from 'ajv'
import rimrafOriginal from 'rimraf'
import pack from 'ajv-pack'
import FA from 'fasy'
import fs from 'fs-extra'
import yaml from 'js-yaml'
import path from 'path'
import prettier from 'prettier'
import {
  quicktype,
  InputData,
  JSONSchema,
  JSONSchemaInput,
  JSONSchemaStore,
  parseJSON,
  QuickTypeError,
} from 'quicktype-core'
import util from 'util'

import { findModuleRoot } from '../lib/findModuleRoot'
import { StringMap } from 'quicktype-core/dist/support/Support'

const rimraf = util.promisify(rimrafOriginal)

const SCHEMA_EXTENSION = '.yml'

class Store extends JSONSchemaStore {
  private schemasRoot: string

  constructor(schemasRoot: string) {
    super()
    this.schemasRoot = schemasRoot
  }

  async fetch(address: string): Promise<JSONSchema | undefined> {
    const schemaFilepath = path.join(this.schemasRoot, address)
    const jsonSchemaString = (await fs.readFile(schemaFilepath)).toString('utf-8')
    return parseJSON(jsonSchemaString, 'JSON Schema', address)
  }
}

function quicktypesAddSources(schemasRoot: string, schemaInput: JSONSchemaInput) {
  return async (schemaFilename: string) => {
    const schemaFilepath = path.join(schemasRoot, schemaFilename)
    const typeName = schemaFilename.replace(SCHEMA_EXTENSION, '')
    const jsonSchemaString = (await fs.readFile(schemaFilepath)).toString('utf-8')
    schemaInput.addSource({ name: typeName, schema: jsonSchemaString })
  }
}

async function quicktypesGenerate(
  lang: string,
  schemasRoot: string,
  schemaFilenames: string[],
  outputPath: string,
  rendererOptions?: { [name: string]: string },
) {
  const schemaInput = new JSONSchemaInput(new Store(schemasRoot))
  await FA.concurrent.forEach(quicktypesAddSources(schemasRoot, schemaInput), schemaFilenames)

  const inputData = new InputData()
  inputData.addInput(schemaInput)

  const { lines } = await quicktype({ inputData, lang, rendererOptions })
  let code = lines.join('\n')

  if (lang === 'typescript') {
    code = prettier.format(code, { parser: 'typescript' })
  }
  return fs.writeFile(outputPath, code)
}

function ajvAddSources(schemasRoot: string, ajv: AjvModule) {
  return async (schemaFilename: string) => {
    const schemaFilepath = path.join(schemasRoot, schemaFilename)
    const jsonSchemaString = fs.readFileSync(schemaFilepath).toString('utf-8')
    const schema = yaml.safeLoad(jsonSchemaString)
    ajv.addSchema(schema)
  }
}

function ajvGenerateOne(schemasRoot: string, ajv: AjvModule, outputDir: string) {
  return async (schemaFilename: string) => {
    const schemaFilepath = path.join(schemasRoot, schemaFilename)
    const typeName = schemaFilename.replace(SCHEMA_EXTENSION, '')
    const jsonSchemaString = fs.readFileSync(schemaFilepath).toString('utf-8')
    const schema = yaml.safeLoad(jsonSchemaString)
    const validateFunction = ajv.compile(schema)
    let code = pack(ajv, validateFunction)
    code = prettier.format(code, { parser: 'babel' })
    return fs.writeFile(path.join(outputDir, `validate${typeName}.js`), code)
  }
}

async function ajvGenerate(schemasRoot: string, schemaFilenames: string[], outputDir: string) {
  const ajv = new Ajv({ sourceCode: true, $data: true, jsonPointers: true })
  await FA.concurrent.forEach(ajvAddSources(schemasRoot, ajv), schemaFilenames)
  return FA.concurrent.forEach(ajvGenerateOne(schemasRoot, ajv, outputDir), schemaFilenames)
}

export default async function generateTypes() {
  const { moduleRoot } = findModuleRoot()
  const schemasRoot = path.join(moduleRoot, 'schemas')
  const tsOutputDir = path.join(moduleRoot, 'src', '.generated')
  const pyOutputDir = path.join(moduleRoot, 'data', 'generated')
  const tsOutput = path.join(tsOutputDir, 'types.ts')
  const pyOutput = path.join(pyOutputDir, 'types.py')

  let schemaFilenames = await fs.readdir(schemasRoot)
  schemaFilenames = schemaFilenames.filter((schemaFilename) => schemaFilename.endsWith(SCHEMA_EXTENSION))

  await FA.concurrent.forEach(fs.mkdirp, [tsOutputDir, pyOutputDir])

  return Promise.all([
    quicktypesGenerate('typescript', schemasRoot, schemaFilenames, tsOutput, {
      'converters': 'all-objects',
      'nice-property-names': 'true',
      'runtime-typecheck': 'true',
    }),
    quicktypesGenerate('python', schemasRoot, schemaFilenames, pyOutput, {
      // 'no-combine-classes': 'true',
      'python-version': '3.6',
      'alphabetize-properties': 'false',
    }),
    ajvGenerate(schemasRoot, schemaFilenames, tsOutputDir),
  ])
}

generateTypes().catch(console.error)