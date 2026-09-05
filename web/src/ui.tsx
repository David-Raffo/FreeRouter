/** Piezas de presentación compartidas entre pestañas. */

/**
 * Longitud a la que se corta el nombre de un modelo.
 *
 * Los ids largos existen de verdad —`nvidia/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning`
 * son 51 caracteres— y las celdas de tabla no parten líneas, así que uno solo estiraba la
 * tabla entera hasta sacar la mitad de las columnas de la pantalla.
 */
const MAX_MODEL_NAME = 45;

export function truncate(text: string, max = MAX_MODEL_NAME): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Nombre de un modelo, recortado, con el completo al pasar el ratón.
 *
 * Nunca se pierde información: lo que no cabe sigue estando en el `title` y se puede
 * copiar del panel de detalle.
 */
export function ModelName({ providerId, modelId }: { providerId: string; modelId: string }) {
  const full = `${providerId}/${modelId}`;
  const short = truncate(full);
  return (
    <span title={short === full ? undefined : full}>
      <span className="dim">{providerId}/</span>
      <span className="mono">{truncate(modelId, MAX_MODEL_NAME - providerId.length - 1)}</span>
    </span>
  );
}
