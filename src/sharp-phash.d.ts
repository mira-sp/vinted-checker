declare module "sharp-phash" {
  export default function phash(input: Buffer | string): Promise<string>;
}