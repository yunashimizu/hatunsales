import { Injectable, Logger } from '@nestjs/common';
import { join } from 'path';
import { promises as fs } from 'fs';

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private basePath: string;

  constructor() {
    // base path relative to project root; can be made configurable
    this.basePath = process.env.PRODUCT_IMAGES_PATH || 'uploads/products';
  }

  async ensureDir(path: string) {
    try {
      await fs.mkdir(path, { recursive: true });
    } catch (err) {
      // ignore
    }
  }

  async saveBuffer(filePath: string, buffer: Buffer) {
    const full = join(this.basePath, filePath);
    await this.ensureDir(join(this.basePath, '..'));
    await this.ensureDir(this.basePath);
    const dir = full.substring(0, full.lastIndexOf('/'));
    await this.ensureDir(dir);
    await fs.writeFile(full, buffer);
    return full;
  }

  async delete(filePath: string) {
    const full = join(this.basePath, filePath);
    try {
      await fs.unlink(full);
      return true;
    } catch (err) {
      this.logger.warn(`No pude eliminar archivo ${full}: ${err.message}`);
      return false;
    }
  }

  async generateThumbnail(originalPath: string, thumbPath: string, width = 300) {
    // Try to use sharp if available, otherwise fall back to a simple copy
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const sharp = require('sharp');
      const src = join(this.basePath, originalPath);
      const dst = join(this.basePath, thumbPath);
      await this.ensureDir(dst.substring(0, dst.lastIndexOf('/')));
      await sharp(src).resize({ width }).toFile(dst);
      return dst;
    } catch (err) {
      // fallback: copy original as thumbnail
      try {
        const src = join(this.basePath, originalPath);
        const dst = join(this.basePath, thumbPath);
        await this.ensureDir(dst.substring(0, dst.lastIndexOf('/')));
        await fs.copyFile(src, dst);
        return dst;
      } catch (copyErr) {
        this.logger.error(`No pude generar thumbnail: ${copyErr.message}`);
        return null;
      }
    }
  }
}
