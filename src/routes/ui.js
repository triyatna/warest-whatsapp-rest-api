import express from "express";
import path from "node:path";
import fsp from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { minify } from "html-minifier-terser";
import { transform } from "esbuild";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const UI_DIR = path.join(__dirname, "../ui");

const router = express.Router();

const htmlCache = new Map();
const jsCache = new Map();

export async function getMinifiedHtml(filename) {
  const filePath = path.join(UI_DIR, filename);
  const stat = await fsp.stat(filePath);
  const cache = htmlCache.get(filePath);
  if (cache && cache.mtimeMs === stat.mtimeMs) return cache.payload;
  const raw = await fsp.readFile(filePath, "utf8");
  const payload = await minify(raw, {
    collapseWhitespace: true,
    conservativeCollapse: true,
    removeComments: true,
    removeRedundantAttributes: true,
    useShortDoctype: true,
    keepClosingSlash: true,
    minifyCSS: true,
    minifyJS: false,
    decodeEntities: true,
  });
  htmlCache.set(filePath, { payload, mtimeMs: stat.mtimeMs });
  return payload;
}

export async function getMinifiedJs(filename) {
  const filePath = path.join(UI_DIR, filename);
  const stat = await fsp.stat(filePath);
  const cache = jsCache.get(filePath);
  if (cache && cache.mtimeMs === stat.mtimeMs) return cache.payload;
  const raw = await fsp.readFile(filePath, "utf8");
  const result = await transform(raw, {
    loader: "js",
    minify: true,
    target: "es2019",
    legalComments: "none",
    format: "iife",
  });
  jsCache.set(filePath, { payload: result.code, mtimeMs: stat.mtimeMs });
  return result.code;
}

router.get("/", async (req, res, next) => {
  try {
    const html = await getMinifiedHtml("index.html");
    res.set("Content-Type", "text/html; charset=utf-8");
    res.set("Cache-Control", "public, max-age=600");
    res.send(html);
  } catch (err) {
    next(err);
  }
});

router.get("/assets/js/:file", async (req, res, next) => {
  try {
    const { file } = req.params;
    if (!/^[\w.-]+\.js$/i.test(file)) return res.status(404).end();
    const js = await getMinifiedJs(path.join("assets", "js", file));
    res.set("Content-Type", "application/javascript; charset=utf-8");
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    res.send(js);
  } catch (err) {
    next(err);
  }
});

router.get("/:file(app|auth|docs).js", async (req, res, next) => {
  try {
    const file = `${req.params.file}.js`;
    const js = await getMinifiedJs(file);
    res.set("Content-Type", "application/javascript; charset=utf-8");
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    res.send(js);
  } catch (err) {
    next(err);
  }
});

const staticOptions = {
  etag: true,
  lastModified: true,
  maxAge: "7d",
  setHeaders(res, filePath) {
    const ext = path.extname(filePath);
    if (ext === ".html") {
      res.setHeader("Cache-Control", "public, max-age=300");
    } else if (/\.(js|css|svg|png|jpg|jpeg|webp|woff2?)$/i.test(ext)) {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    }
  },
};

router.use(express.static(UI_DIR, staticOptions));

export default router;
