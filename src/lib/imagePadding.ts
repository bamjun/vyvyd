export type ImagePaddingAlignment = 'top' | 'center' | 'bottom';

/** Keep every source pixel while adding enough vertical space for a 9:16 canvas. */
export const getImagePaddingLayout = (
  width: number,
  height: number,
  alignment: ImagePaddingAlignment = 'top',
) => {
  const outputHeight = Math.max(Math.ceil((width * 16) / 9), height);
  const extraHeight = outputHeight - height;
  const y = alignment === 'center' ? Math.floor(extraHeight / 2)
    : alignment === 'bottom' ? extraHeight : 0;

  return { width, height, outputHeight, x: 0, y };
};
