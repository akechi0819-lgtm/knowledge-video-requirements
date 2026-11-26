import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { childEnvironment, resolveTool } from '../lib/runtime.js'

const run = promisify(execFile)

export async function createMutedVideo(file, duration, color = 'blue') {
  const ffmpeg = resolveTool('ffmpeg')
  const ffprobe = resolveTool('ffprobe')
  await run(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=' + color + ':s=320x180:r=30',
    '-t', String(duration), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', file],
  { env: childEnvironment(process.env, [ffmpeg]), windowsHide: true })
  return { ffmpeg, ffprobe }
}
