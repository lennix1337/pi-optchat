import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'transcribe.py');

/** A voice note as text, by the local faster-whisper script; rejects with the reason when the file, python or the model is missing. */
export function transcribeAudio(audioPath: string, python = process.env.OPTCHAT_PYTHON || 'python3'): Promise<string> {
  if (!existsSync(audioPath)) return Promise.reject(new Error('arquivo ausente'));
  return new Promise((resolve, reject) => {
    execFile(python, [SCRIPT, audioPath], { timeout: 300_000, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr?.trim().split('\n').pop() || error.message));
      else resolve(stdout);
    });
  });
}
