// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// One texture → a KTX2 file with ASTC blocks (the GPU keeps them compressed), its whole
// mip chain, zstd-supercompressed for the download.
//
// Why ASTC, natively and not Basis: every phone from 2021 on (iOS: all Apple GPUs since
// the A8; Android: Adreno, Mali, PowerVR, Xclipse) samples ASTC in hardware, and
// three.js loads ASTC KTX2 without a transcoder. Basis UASTC would cost a WASM
// transcoder and, transcoded to ASTC, the 4×4 block anyway; ASTC chosen here per
// texture goes down to 8×8 (2 bits per pixel instead of 32 for RGBA8: 16× less GPU
// memory) wherever the result stays as good as the original.
//
// The block is chosen by measuring: the texture is encoded at 8×8, decoded back, and
// compared with the original on two counts, both of which must pass:
//  - SSIM channel by channel (red, green, blue and, with transparency, alpha): the
//    overall structure, at least MIN_SSIM
//  - PSNR of its worst parts: the texture cut in 16×16 tiles, the 1st percentile of
//    their PSNR at least MIN_TILE_PSNR. SSIM averages over the whole texture, and
//    wide flat areas hide blocky edges where a pattern is (a knit's diamonds seen
//    up close in the profile); this catches them
// Otherwise it tries 6×6, then 4×4 (near-lossless). A texture that fails even at 4×4
// (glitter, wireframe grids: noise-like detail) is not compressed: `passed` is false and
// the caller keeps the original. The app loads these with its own small loader
// (webview/avatar/src/astcTexture.js): three.js's KTX2Loader maps only 4×4 and 6×6.
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { zstdCompressSync, constants as zlib } from 'node:zlib';
import sharp from 'sharp';
import ssimModule from 'ssim.js';
import {
  KHR_DF_MODEL_ASTC, KHR_DF_TRANSFER_LINEAR, KHR_DF_TRANSFER_SRGB, KHR_SUPERCOMPRESSION_ZSTD,
  VK_FORMAT_ASTC_4x4_SRGB_BLOCK, VK_FORMAT_ASTC_4x4_UNORM_BLOCK, VK_FORMAT_ASTC_6x6_SRGB_BLOCK,
  VK_FORMAT_ASTC_6x6_UNORM_BLOCK, VK_FORMAT_ASTC_8x8_SRGB_BLOCK, VK_FORMAT_ASTC_8x8_UNORM_BLOCK,
  createDefaultContainer, write,
} from 'ktx-parse';

const run = promisify(execFile);
const ssim = ssimModule.ssim ?? ssimModule.default?.ssim ?? ssimModule;

export const SETTINGS = {
  // Lowest structural similarity of any channel to the original: asked "95 %
  // identical", kept a little stricter so that the look is never at stake
  MIN_SSIM: 0.97,
  // Worst areas (1st percentile of 16×16 tiles) at least this PSNR: visually lossless
  // even magnified, calibrated on the textures with sharp patterns
  MIN_TILE_PSNR: 38,
  // Largest side: the avatars stand a few hundred pixels tall at most
  MAX_SIZE: 1024,
  // astcenc search effort: -thorough is the best quality short of -exhaustive
  QUALITY: '-thorough',
  ZSTD_LEVEL: 19,
};
const BLOCKS = [
  { name: '8x8', size: [8, 8], formats: { srgb: VK_FORMAT_ASTC_8x8_SRGB_BLOCK, linear: VK_FORMAT_ASTC_8x8_UNORM_BLOCK } },
  { name: '6x6', size: [6, 6], formats: { srgb: VK_FORMAT_ASTC_6x6_SRGB_BLOCK, linear: VK_FORMAT_ASTC_6x6_UNORM_BLOCK } },
  { name: '4x4', size: [4, 4], formats: { srgb: VK_FORMAT_ASTC_4x4_SRGB_BLOCK, linear: VK_FORMAT_ASTC_4x4_UNORM_BLOCK } },
];

// SSIM of one channel (0 R, 1 G, 2 B, 3 A) of two RGBA images of the same size
function channelSsim(a, b, width, height, channel) {
  const gray = (source) => {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      const v = source[i * 4 + channel];
      data[i * 4] = v;
      data[i * 4 + 1] = v;
      data[i * 4 + 2] = v;
      data[i * 4 + 3] = 255;
    }
    return { data, width, height };
  };
  return ssim(gray(a), gray(b), { ssim: 'weber' }).mssim;
}

// The pixel values as stored, as the GPU gets them: three.js decodes images without
// colour conversion, so an embedded ICC profile must not be applied here either
const read = (input) => sharp(input, { ignoreIcc: true });

// PSNR of the worst areas: 1st percentile over 16×16 tiles, on the given channels
function worstTilesPsnr(a, b, width, height, channels) {
  const TILE = 16;
  const tiles = [];
  for (let ty = 0; ty < height; ty += TILE) {
    for (let tx = 0; tx < width; tx += TILE) {
      let error = 0;
      let count = 0;
      for (let y = ty; y < Math.min(ty + TILE, height); y++) {
        for (let x = tx; x < Math.min(tx + TILE, width); x++) {
          for (const channel of channels) {
            const i = (y * width + x) * 4 + channel;
            const e = a[i] - b[i];
            error += e * e;
            count++;
          }
        }
      }
      tiles.push(error === 0 ? 99 : 10 * Math.log10((255 * 255) / (error / count)));
    }
  }
  tiles.sort((x, y) => x - y);
  return tiles[Math.floor(tiles.length * 0.01)];
}

async function rgba(input) {
  const { data, info } = await read(input).ensureAlpha().raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/**
 * @param {Buffer} input  PNG or JPEG bytes
 * @param {{ srgb: boolean, astcenc: string, threads?: number }} options
 * @returns {Promise<{ ktx2: Uint8Array, block: string, ssim: number, width: number, height: number, alpha: boolean }>}
 */
export async function encodeTexture(input, { srgb, astcenc, threads = 2 }) {
  const work = await mkdtemp(path.join(tmpdir(), 'astc-'));
  try {
    // The top level, capped
    let image = read(input).ensureAlpha();
    const meta = await read(input).metadata();
    const scale = Math.min(1, SETTINGS.MAX_SIZE / Math.max(meta.width, meta.height));
    const width = Math.max(1, Math.round(meta.width * scale));
    const height = Math.max(1, Math.round(meta.height * scale));
    if (scale < 1) image = image.resize(width, height, { kernel: 'lanczos3' });
    const top = await image.png().toBuffer();
    const original = await rgba(top);
    let alpha = false;
    for (let i = 3; i < original.data.length; i += 4) if (original.data[i] < 255) { alpha = true; break; }

    const mode = srgb ? 's' : 'l';
    const topPath = path.join(work, 'level0.png');
    await read(top).toFile(topPath);

    // The smallest block whose decoded result stays similar enough
    let chosen = BLOCKS[BLOCKS.length - 1];
    let score = 1;
    let tilePsnr = 99;
    for (const block of BLOCKS) {
      const decoded = path.join(work, `test-${block.name}.png`);
      await run(astcenc, [`-t${mode}`, topPath, decoded, block.name, SETTINGS.QUALITY, '-j', String(threads), '-silent']);
      const result = await rgba(await readFile(decoded));
      const channels = alpha ? [0, 1, 2, 3] : [0, 1, 2];
      score = Math.min(...channels.map((channel) => channelSsim(original.data, result.data, width, height, channel)));
      tilePsnr = worstTilesPsnr(original.data, result.data, width, height, channels);
      chosen = block;
      if (score >= SETTINGS.MIN_SSIM && tilePsnr >= SETTINGS.MIN_TILE_PSNR) break;
    }

    // Every level of the mip chain, from the capped top level
    const levels = [];
    for (let level = 0, w = width, h = height; ; level++) {
      const levelPath = path.join(work, `level${level}.png`);
      if (level > 0) await read(top).resize(w, h, { kernel: 'lanczos3', fit: 'fill' }).png().toFile(levelPath);
      const astcPath = path.join(work, `level${level}.astc`);
      await run(astcenc, [`-c${mode}`, levelPath, astcPath, chosen.name, SETTINGS.QUALITY, '-j', String(threads), '-silent']);
      const blocks = (await readFile(astcPath)).subarray(16); // after the .astc header
      levels.push(blocks);
      if (w === 1 && h === 1) break;
      w = Math.max(1, w >> 1);
      h = Math.max(1, h >> 1);
    }

    const gpuBytes = levels.reduce((sum, data) => sum + data.byteLength, 0);
    const passed = score >= SETTINGS.MIN_SSIM && tilePsnr >= SETTINGS.MIN_TILE_PSNR;
    return { ktx2: ktx2Container(levels, chosen, { width, height, srgb }), block: chosen.name, ssim: score, tilePsnr, width, height, alpha, gpuBytes, passed };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

// ASTC levels (raw blocks, largest first) → a KTX2 file, zstd-supercompressed
function ktx2Container(levels, block, { width, height, srgb }) {
  const container = createDefaultContainer();
  container.vkFormat = block.formats[srgb ? 'srgb' : 'linear'];
  container.typeSize = 1;
  container.pixelWidth = width;
  container.pixelHeight = height;
  container.levelCount = levels.length;
  container.supercompressionScheme = KHR_SUPERCOMPRESSION_ZSTD;
  container.levels = levels.map((data) => ({
    levelData: new Uint8Array(zstdCompressSync(data, { params: { [zlib.ZSTD_c_compressionLevel]: SETTINGS.ZSTD_LEVEL } })),
    uncompressedByteLength: data.byteLength,
  }));
  const dfd = container.dataFormatDescriptor[0];
  dfd.colorModel = KHR_DF_MODEL_ASTC;
  dfd.transferFunction = srgb ? KHR_DF_TRANSFER_SRGB : KHR_DF_TRANSFER_LINEAR;
  dfd.texelBlockDimension = [block.size[0] - 1, block.size[1] - 1, 0, 0];
  dfd.bytesPlane = [0, 0, 0, 0, 0, 0, 0, 0]; // supercompressed
  dfd.samples = [{
    bitOffset: 0, bitLength: 127, channelType: 0, samplePosition: [0, 0, 0, 0], sampleLower: 0, sampleUpper: 0xFFFFFFFF,
  }];
  return write(container);
}

/**
 * Ready-made levels (raw RGBA8, largest first, each half the one before) → a KTX2 file
 * with one fixed ASTC block, for textures that must all share one format (the map
 * avatars' atlases, layers of one array texture on the GPU).
 * @param {{ data: Buffer, width: number, height: number }[]} images
 * @param {{ block: '4x4'|'6x6'|'8x8', srgb: boolean, astcenc: string, threads?: number }} options
 */
export async function encodeLevels(images, { block: blockName, srgb, astcenc, threads = 2 }) {
  const block = BLOCKS.find((candidate) => candidate.name === blockName);
  const work = await mkdtemp(path.join(tmpdir(), 'astc-'));
  try {
    const levels = [];
    for (const [level, image] of images.entries()) {
      const levelPath = path.join(work, `level${level}.png`);
      await sharp(image.data, { raw: { width: image.width, height: image.height, channels: 4 } }).png().toFile(levelPath);
      const astcPath = path.join(work, `level${level}.astc`);
      await run(astcenc, [`-c${srgb ? 's' : 'l'}`, levelPath, astcPath, block.name, SETTINGS.QUALITY, '-j', String(threads), '-silent']);
      levels.push((await readFile(astcPath)).subarray(16));
    }
    return ktx2Container(levels, block, { width: images[0].width, height: images[0].height, srgb });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
