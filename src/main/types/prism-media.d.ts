/**
 * prism-media ships no TypeScript declarations and there is no
 * @types/prism-media package, so this is a minimal ambient declaration
 * covering only what StreamingManager.ts actually uses (the Opus encoder).
 */
declare module 'prism-media' {
  import { Transform, TransformOptions } from 'node:stream';

  interface OpusCodecOptions extends TransformOptions {
    rate: number;
    channels: number;
    frameSize: number;
  }

  namespace opus {
    class Encoder extends Transform {
      constructor(options: OpusCodecOptions);
    }
    class Decoder extends Transform {
      constructor(options: OpusCodecOptions);
    }
  }

  const prism: { opus: typeof opus };
  export default prism;
  export { opus };
}
