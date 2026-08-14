export function invitationStorageKey(classroomId: string, invitationId: string): string {
  return `ledgerlines:classroom-invitation:${classroomId}:${invitationId}`;
}

export function buildLoginReturnUri(
  origin: string,
  pathname: string,
  classroomId: string,
  invitationId: string,
): string {
  const returnUri = new URL(pathname, origin);
  returnUri.searchParams.set("classroomId", classroomId);
  returnUri.searchParams.set("invitationId", invitationId);
  return returnUri.toString();
}
