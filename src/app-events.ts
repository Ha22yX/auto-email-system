export function parseEmailReadStateEvent(data: string) {
  try {
    const event = JSON.parse(data) as {
      type?: unknown;
      payload?: { id?: unknown; panelRead?: unknown; panelReadAt?: unknown };
    };
    const payload = event.payload;
    if (
      event.type !== "email-read-state" ||
      typeof payload?.id !== "string" ||
      !payload.id ||
      typeof payload.panelRead !== "boolean"
    ) {
      return undefined;
    }
    return {
      id: payload.id,
      panelRead: payload.panelRead,
      panelReadAt:
        payload.panelRead && typeof payload.panelReadAt === "string"
          ? payload.panelReadAt
          : undefined
    };
  } catch {
    return undefined;
  }
}