declare module 'heic-decode' {
  interface DecodedHeic {
    width: number;
    height: number;
    /** RGBA pixels, 4 channels. */
    data: ArrayBuffer;
  }
  function decode(options: { buffer: Buffer | Uint8Array }): Promise<DecodedHeic>;
  export = decode;
}
