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
