import { Injectable, NotFoundException } from '@nestjs/common';
import { ProductoImagenRepository } from '../../repository/Repository/producto-imagen.repository';
import { ProductoRepository } from '../../repository/Repository/producto.repository';
import { StorageService } from '../../util/storage/storage.service';
import { ProductoImagen } from '../../models/DBModel/producto-imagen.entity';

@Injectable()
export class ProductoImagenBussnies {
  constructor(
    private readonly repo: ProductoImagenRepository,
    private readonly productoRepo: ProductoRepository,
    private readonly storage: StorageService,
  ) {}

  async listByProduct(id_producto: number) {
    return this.repo.findByProducto(id_producto);
  }

  async uploadBuffer(id_producto: number, filename: string, buffer: Buffer, mime: string) {
    const producto = await this.productoRepo.getById(id_producto);
    if (!producto) throw new NotFoundException('Producto no encontrado');

    // build paths
    const dir = `${id_producto}`;
    const filePath = `${dir}/${Date.now()}_${filename}`;
    await this.storage.saveBuffer(filePath, buffer);

    const thumbPath = `${dir}/thumb_${Date.now()}_${filename}`;
    await this.storage.generateThumbnail(filePath, thumbPath, 300);

    const img = new ProductoImagen();
    img.producto = producto as any;
    img.url = filePath;
    img.thumb_url = thumbPath;
    img.mime = mime;
    img.size = buffer.length;

    // if it's the first image, mark primary
    const existing = await this.repo.findByProducto(id_producto);
    img.is_primary = existing.length === 0;

    return this.repo.create(img);
  }

  async setPrimary(id_producto: number, id_imagen: number) {
    const imgs = await this.repo.findByProducto(id_producto);
    if (!imgs || imgs.length === 0) throw new NotFoundException('Imagenes no encontradas');
    const found = imgs.find(i => i.id_imagen === id_imagen);
    if (!found) throw new NotFoundException('Imagen no encontrada');

    // unset previous
    await Promise.all(imgs.map(i => {
      if (i.is_primary && i.id_imagen !== id_imagen) {
        i.is_primary = false;
        return this.repo.update(i.id_imagen as any, i as any);
      }
      return Promise.resolve(null);
    }));

    found.is_primary = true;
    return this.repo.update(found.id_imagen as any, found as any);
  }

  async remove(id_producto: number, id_imagen: number) {
    const img = await this.repo.findOneById(id_imagen);
    if (!img || (img.producto && (img.producto as any).id_producto !== id_producto)) throw new NotFoundException('Imagen no encontrada');
    // delete files
    if (img.url) await this.storage.delete(img.url);
    if (img.thumb_url) await this.storage.delete(img.thumb_url);
    return this.repo.delete(id_imagen);
  }
}
