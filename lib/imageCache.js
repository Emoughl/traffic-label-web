const imageCache = new Map();

export function getCachedImage(src) {
  if (!src || typeof window === "undefined") {
    return Promise.resolve(null);
  }

  const cached = imageCache.get(src);
  if (cached) {
    if (cached.img.complete) return Promise.resolve(cached.img);
    return Promise.resolve(cached.img);
  }

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.loading = "eager";
    img.onload = () => {
      imageCache.set(src, { img, ts: Date.now() });
      resolve(img);
    };
    img.onerror = () => reject(new Error(`Failed to load image: ${src}`));
    img.src = src;
  });
}

export function preloadImage(src) {
  if (!src) return null;
  const cached = imageCache.get(src);
  if (cached?.img) return cached.img;

  getCachedImage(src).catch(() => null);
  return null;
}

/**
 * Preload full-resolution image for a given image ID.
 * Returns immediately; loading happens in background.
 */
export function preloadFullImage(imageId) {
  if (!imageId) return;
  const src = `/api/drive/image/${imageId}`;
  preloadImage(src);
}

/**
 * Check if a full-resolution image is already cached (loaded & complete).
 */
export function isFullImageCached(imageId) {
  if (!imageId) return false;
  const src = `/api/drive/image/${imageId}`;
  const cached = imageCache.get(src);
  return !!(cached?.img?.complete);
}

/**
 * Preload full-resolution images for neighbor indexes around current.
 * Call this on every index change to keep ±range neighbors warm.
 */
export function preloadNeighborFullImages(images, currentIndex, range = 3) {
  if (!images?.length) return;
  for (let offset = 1; offset <= range; offset++) {
    const prev = currentIndex - offset;
    const next = currentIndex + offset;
    if (prev >= 0 && images[prev]) preloadFullImage(images[prev].id);
    if (next < images.length && images[next]) preloadFullImage(images[next].id);
  }
}
