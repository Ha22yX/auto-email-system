export type ImageNotificationResult = {
  mode: "image" | "text-fallback";
  imageError?: string;
};

function safeImageError(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim().slice(0, 160);
}

export async function sendImageNotificationWithTextFallback(options: {
  renderImage: () => Promise<Buffer>;
  sendImage: (image: Buffer) => Promise<unknown>;
  sendText: () => Promise<unknown>;
}): Promise<ImageNotificationResult> {
  try {
    const image = await options.renderImage();
    await options.sendImage(image);
    return { mode: "image" };
  } catch (imageError) {
    await options.sendText();
    return { mode: "text-fallback", imageError: safeImageError(imageError) };
  }
}
