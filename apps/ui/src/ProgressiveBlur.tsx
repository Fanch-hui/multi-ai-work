const radii = [1, 2, 4, 8, 16, 24];

export function ProgressiveBlur({ edge }: { edge: 'top' | 'bottom' }) {
  const direction = edge === 'top' ? 'to top' : 'to bottom';
  const step = 100 / radii.length;
  return <div aria-hidden="true" className={`progressive-blur progressive-blur-${edge}`}>
    {radii.map((radius, index) => {
      const mask = `linear-gradient(${direction}, transparent ${index * step}%, black ${(index + 1) * step}%, black ${(index + 2) * step}%, transparent ${(index + 3) * step}%)`;
      return <span key={radius} style={{
        backdropFilter: `blur(${radius}px)`, WebkitBackdropFilter: `blur(${radius}px)`,
        maskImage: mask, WebkitMaskImage: mask,
      }} />;
    })}
  </div>;
}
