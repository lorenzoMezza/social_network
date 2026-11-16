// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import * as THREE from 'three';
import { read, KHR_SUPERCOMPRESSION_ZSTD } from 'three/addons/libs/ktx-parse.module.js';
import { ZSTDDecoder } from 'three/addons/libs/zstddec.module.js';

// Loads the textures of the optimised avatar library (asset-pipeline/): KTX2 files
// holding ASTC blocks as the GPU samples them (4×4, 6×6 or 8×8, all mip levels),
// zstd-supercompressed. No transcoder: the levels are unpacked and handed to WebGL
// as they are. three.js's KTX2Loader would do the same, but maps only 4×4 and 6×6.
// A loader for GLTFLoader (setKTX2Loader: KHR_texture_basisu images) and for files.

// vkFormat → three.js format (sRGB and UNORM share one; the colour space says which)
const FORMATS = {
  157: THREE.RGBA_ASTC_4x4_Format, 158: THREE.RGBA_ASTC_4x4_Format,
  165: THREE.RGBA_ASTC_6x6_Format, 166: THREE.RGBA_ASTC_6x6_Format,
  171: THREE.RGBA_ASTC_8x8_Format, 172: THREE.RGBA_ASTC_8x8_Format,
};
const SRGB_FORMATS = new Set([158, 166, 172]);

// One decoder for every texture, ready once (textures arrive together: each waits)
let zstdReady = null;
const zstdDecoder = () => {
  zstdReady ??= (async () => {
    const decoder = new ZSTDDecoder();
    await decoder.init();
    return decoder;
  })();
  return zstdReady;
};

/** Whether this renderer can show the optimised library (ASTC in hardware) */
export function supportsAstc(renderer) {
  return renderer.extensions.has('WEBGL_compressed_texture_astc');
}

export class AstcTextureLoader extends THREE.Loader {
  load(url, onLoad, onProgress, onError) {
    const files = new THREE.FileLoader(this.manager);
    files.setResponseType('arraybuffer');
    files.setRequestHeader(this.requestHeader);
    files.setWithCredentials(this.withCredentials);
    const fail = (error) => {
      console.error('AstcTextureLoader:', url, error?.message ?? error);
      onError?.(error);
      this.manager.itemError(url);
    };
    files.load(url, (buffer) => {
      this.parse(buffer).then(onLoad).catch(fail);
    }, onProgress, fail);
  }

  async parse(buffer) {
    const container = read(new Uint8Array(buffer));
    const format = FORMATS[container.vkFormat];
    if (format === undefined) throw new Error(`AstcTextureLoader: unsupported vkFormat ${container.vkFormat}`);
    const zstd = container.supercompressionScheme === KHR_SUPERCOMPRESSION_ZSTD ? await zstdDecoder() : null;
    const mipmaps = container.levels.map((level, index) => ({
      data: zstd ? zstd.decode(level.levelData, level.uncompressedByteLength) : level.levelData,
      width: Math.max(1, container.pixelWidth >> index),
      height: Math.max(1, container.pixelHeight >> index),
    }));
    const texture = new THREE.CompressedTexture(mipmaps, container.pixelWidth, container.pixelHeight, format, THREE.UnsignedByteType);
    texture.colorSpace = SRGB_FORMATS.has(container.vkFormat) ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    texture.minFilter = mipmaps.length > 1 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    return texture;
  }
}
