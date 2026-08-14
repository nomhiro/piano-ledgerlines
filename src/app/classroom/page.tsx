import ClassroomView from "@/components/ClassroomView";
import { getAccountContextForLayout } from "@/lib/server/account";

export const dynamic = "force-dynamic";

export default async function ClassroomPage({
  searchParams,
}: {
  searchParams: Promise<{ classroomId?: string }>;
}) {
  const account = await getAccountContextForLayout();
  const { classroomId: selectedId } = await searchParams;
  const initialClassroom =
    account?.classrooms.find((classroom) => classroom.id === selectedId) ??
    account?.activeClassroom ??
    account?.classrooms[0] ??
    null;
  return <ClassroomView account={account} initialClassroom={initialClassroom} />;
}
