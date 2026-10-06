/** CEP's drag of a file into Premiere's Project panel or timeline, as from Finder (VibeCut's cep.tsx
 * `fillDrag`). Premiere reads the path from CEP's `com.adobe.cep.dnd.file.0` data type. */
export function fillDrag(path: string, data: DataTransfer): boolean {
  data.effectAllowed = "copy";
  data.setData("com.adobe.cep.dnd.file.0", path);
  return true;
}
