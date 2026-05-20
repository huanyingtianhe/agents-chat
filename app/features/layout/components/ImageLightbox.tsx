'use client';

export type ImageLightboxProps = {
  src: string;
  onClose: () => void;
};

export function ImageLightbox({ src, onClose }: ImageLightboxProps) {
  return (
    <div className="lightboxOverlay" onClick={onClose}>
      <img src={src} className="lightboxImg" alt="Full size preview" onClick={(e) => e.stopPropagation()} />
      <button className="lightboxClose" onClick={onClose} aria-label="Close">×</button>
    </div>
  );
}
