"""Small CPU embeddings, private to the server and cached in the admin volume."""

import os
import threading

MODEL_NAME = "BAAI/bge-small-zh-v1.5"
_lock = threading.Lock()
_model = None


def embed(args):
    global _model
    texts = args.get("input", [])
    if isinstance(texts, str):
        texts = [texts]
    if not isinstance(texts, list) or not 1 <= len(texts) <= 64:
        raise ValueError("input must contain 1 to 64 texts")
    if any(not isinstance(text, str) or len(text) > 20000 for text in texts):
        raise ValueError("embedding input is too large")
    if args.get("model", MODEL_NAME) != MODEL_NAME:
        raise ValueError("unknown local embedding model")
    with _lock:
        if _model is None:
            from fastembed import TextEmbedding

            cache = "/data/cache/embeddings"
            os.makedirs(cache, exist_ok=True)
            _model = TextEmbedding(MODEL_NAME, cache_dir=cache, threads=2)
        vectors = list(_model.embed(texts, batch_size=16))
    return {
        "model": MODEL_NAME,
        "data": [
            {"index": index, "embedding": vector.tolist()}
            for index, vector in enumerate(vectors)
        ],
    }
