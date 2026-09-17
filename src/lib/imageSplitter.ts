export interface ImageSlice {
  column: number;
  row: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export const getImageSlices = (
  width: number,
  height: number,
  columns: number,
  rows: number,
): ImageSlice[] => {
  const slices: ImageSlice[] = [];

  for (let row = 0; row < rows; row += 1) {
    const y = Math.round((row * height) / rows);
    const nextY = Math.round(((row + 1) * height) / rows);

    for (let column = 0; column < columns; column += 1) {
      const x = Math.round((column * width) / columns);
      const nextX = Math.round(((column + 1) * width) / columns);
      slices.push({
        column,
        row,
        x,
        y,
        width: nextX - x,
        height: nextY - y,
      });
    }
  }

  return slices;
};
