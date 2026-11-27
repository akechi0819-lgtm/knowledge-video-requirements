import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const sourceRoot = fileURLToPath(new URL('../../../../../', import.meta.url))
export const appRoot = path.resolve(process.env.JIANGJIE_APP_ROOT || sourceRoot)
export const defaultKit = path.resolve(process.env.VIDEO_KIT_DIR || path.join(appRoot, 'video-kit'))
const modulePath = 'WORK/modules/video/runtime.mjs'
const bundledRuntime = path.join(appRoot, 'video-kit', modulePath)
export const { childEnvironment, emitDesktopDiagnostic, findExecutable, resolveTool, systemTool, runtimePaths, writablePath } =
  await import(pathToFileURL(existsSync(bundledRuntime) ? bundledRuntime : path.join(defaultKit, modulePath)))
