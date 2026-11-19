// The three ways to attach on the phone (DESIGN.md 6n): the gallery, the camera, and files. Each
// returns the picked files for composerAttachments.ts to upload, none when the user backs out, and
// throws an Error with a Korean reason when a permission is refused.
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import type { PickedFile } from "./composerAttachments.logic.ts";

function fromImages(result: ImagePicker.ImagePickerResult): PickedFile[] {
  if (result.canceled) return [];
  return result.assets.map((a) => ({ uri: a.uri, name: a.fileName, mimeType: a.mimeType, sizeBytes: a.fileSize }));
}

/** Pictures from the gallery (Android's photo picker, no storage permission). The originals go: no crop, no recompression. */
export async function pickPhotos(): Promise<PickedFile[]> {
  return fromImages(await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsMultipleSelection: true, quality: 1 }));
}

/** One picture from the camera. */
export async function takePhoto(): Promise<PickedFile[]> {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) throw new Error("Camera permission is required. Allow it in the app settings");
  return fromImages(await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 1 }));
}

/** Any files; the picker copies each into the app's cache so the upload can read it by path. */
export async function pickFiles(): Promise<PickedFile[]> {
  const result = await DocumentPicker.getDocumentAsync({ type: "*/*", multiple: true, copyToCacheDirectory: true });
  if (result.canceled) return [];
  return result.assets.map((a) => ({ uri: a.uri, name: a.name, mimeType: a.mimeType, sizeBytes: a.size }));
}
