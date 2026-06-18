import readline from "node:readline";

let extractorPromise = null;
let loadedModel = null;

const runtimeImport = new Function(
  "specifier",
  "return import(specifier)",
);

async function extractorFor(model, cacheDir) {
  if (!extractorPromise || loadedModel !== model) {
    const { pipeline, env } = await runtimeImport("@huggingface/transformers");
    env.cacheDir = cacheDir || ".cache/transformers";
    env.allowLocalModels = true;
    env.allowRemoteModels = true;
    loadedModel = model;
    extractorPromise = pipeline("feature-extraction", model);
  }
  return extractorPromise;
}

function tensorToVectors(out) {
  const [rows, cols] =
    out.dims.length >= 2 ? [out.dims[0], out.dims[1]] : [1, out.dims[0]];
  const data = Array.from(out.data);
  const vectors = [];
  for (let row = 0; row < rows; row++) {
    vectors.push(data.slice(row * cols, (row + 1) * cols));
  }
  return vectors;
}

async function handle(line) {
  const req = JSON.parse(line);
  try {
    const extractor = await extractorFor(req.model, req.cacheDir);
    const out = await extractor(req.texts, {
      pooling: "mean",
      normalize: true,
    });
    process.stdout.write(
      `${JSON.stringify({ id: req.id, ok: true, vectors: tensorToVectors(out) })}\n`,
    );
  } catch (err) {
    process.stdout.write(
      `${JSON.stringify({
        id: req.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      })}\n`,
    );
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  void handle(line);
});
