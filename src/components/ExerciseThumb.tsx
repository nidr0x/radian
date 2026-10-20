import { memo, useState } from 'react';
import { Dumbbell } from 'lucide-react';

export const ExerciseThumb = memo(function ExerciseThumb({ src, position, alt, large = false }: { src?: string; position?: string; alt: string; large?: boolean }) {
  const [failed, setFailed] = useState(false);
  const usesAtlas = Boolean(src?.includes('/atlas-') && position);
  const atlasStyle = usesAtlas ? { backgroundImage: `url(${src})`, backgroundPosition: position } : undefined;
  return <div className={large ? 'exercise-thumb large' : 'exercise-thumb'}>{src && !failed ? usesAtlas ? <div className="exercise-thumb-image" style={atlasStyle} role="img" aria-label={alt} /> : <img src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} /> : <div className="exercise-thumb-fallback" aria-label={alt}><Dumbbell size={large ? 30 : 20} /></div>}</div>;
});
