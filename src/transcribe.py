"""Transcribe one audio file to stdout (pt) with faster-whisper: voice notes he sends on Slack. Needs: pip install --user faster-whisper av
Decodes with av directly: faster-whisper's own decoder breaks on av>=19."""
import sys

import av
import numpy as np
from faster_whisper import WhisperModel


def decode(path):
    chunks = []
    resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)
    with av.open(path) as container:
        for frame in container.decode(audio=0):
            for out in resampler.resample(frame):
                chunks.append(out.to_ndarray().reshape(-1))
        for out in resampler.resample(None):
            chunks.append(out.to_ndarray().reshape(-1))
    return np.concatenate(chunks).astype(np.float32) / 32768.0


model = WhisperModel("small", device="cpu", compute_type="int8")
segments, _ = model.transcribe(decode(sys.argv[1]), language="pt", vad_filter=True)
print(" ".join(s.text.strip() for s in segments).strip())
