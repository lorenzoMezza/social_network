// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// One avatar model (GLB) → the same model, lighter for the GPU and the download:
//  - every texture becomes an ASTC KTX2 (texture.mjs), sRGB or linear as its material
//    slot reads it, referenced through KHR_texture_basisu (three.js's KTX2Loader loads
//    native ASTC through it, without a transcoder)
//  - duplicated and unused data dropped (dedup, prune)
//  - vertices reordered for the GPU cache, then normals, UVs, colours and weights
//    quantized (KHR_mesh_quantization: they stay 8/16-bit on the GPU) and all vertex,
//    index and animation data meshopt-compressed (EXT_meshopt_compression)
//
// Positions stay float. Quantized positions need a corrective transform, which for a
// skinned mesh gltf-transform puts in the inverse bind matrices; three.js also applies
// the mesh node's transform before them, and some Decentraland models put their mesh
// node at scale 100 under a 0.01 armature, so the correction would land in the wrong
// space. The app also matches skin vertices of different models by position (seam
// welding, composeAvatar.js). Meshopt still compresses them for the download.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression, KHRTextureBasisu } from '@gltf-transform/extensions';
import { dedup, getTextureColorSpace, prune, quantize, reorder } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';
import { encodeTexture } from './texture.mjs';

await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });

const QUANTIZE = {
  pattern: /^(NORMAL|TANGENT|TEXCOORD|COLOR|WEIGHTS|JOINTS)(_\d+)?$/,
  patternTargets: /^(NORMAL|TANGENT|TEXCOORD|COLOR)(_\d+)?$/,
  quantizeNormal: 10,
  quantizeTexcoord: 12,
  quantizeColor: 8,
  quantizeWeight: 8,
};

/**
 * @param {Uint8Array} glb
 * @param {{ astcenc: string, threads?: number }} options
 * @returns {Promise<{ glb: Uint8Array, textures: object[] }>}
 */
export async function optimizeModel(glb, { astcenc, threads }) {
  const document = await io.readBinary(glb);
  const textures = [];
  let hasKtx2 = false;
  for (const texture of document.getRoot().listTextures()) {
    const image = texture.getImage();
    if (!image || texture.getMimeType() === 'image/ktx2') continue;
    // Color textures are sRGB; data (normal, roughness, occlusion…) linear
    const srgb = getTextureColorSpace(texture) !== 'linear';
    const result = await encodeTexture(Buffer.from(image), { srgb, astcenc, threads });
    const uri = texture.getURI();
    // Too fine to compress without a visible change: kept as it is
    if (result.passed) {
      texture.setImage(result.ktx2).setMimeType('image/ktx2');
      if (uri) texture.setURI(uri.replace(/\.(png|jpe?g|webp)$/i, '.ktx2'));
      hasKtx2 = true;
    }
    textures.push({
      kept: !result.passed,
      name: texture.getName() || uri || `texture${textures.length}`,
      srgb,
      size: `${result.width}x${result.height}`,
      block: result.block,
      ssim: Number(result.ssim.toFixed(4)),
      tilePsnr: Number(result.tilePsnr.toFixed(1)),
      alpha: result.alpha,
      before: image.byteLength,
      after: result.ktx2.byteLength,
      // GPU memory: RGBA8 with mipmaps (what a PNG becomes, at the same capped size)
      // against the ASTC levels
      gpuBefore: Math.round(result.width * result.height * 4 * 4 / 3),
      gpuAfter: result.passed ? result.gpuBytes : Math.round(result.width * result.height * 4 * 4 / 3),
    });
  }
  if (hasKtx2) document.createExtension(KHRTextureBasisu).setRequired(true);

  await document.transform(
    dedup(),
    prune(),
    reorder({ encoder: MeshoptEncoder, target: 'size' }),
    quantize(QUANTIZE),
  );
  document.createExtension(EXTMeshoptCompression).setRequired(true)
    .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
  return { glb: await io.writeBinary(document), textures };
}
