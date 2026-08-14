import ClassroomView from "@/components/ClassroomView";
import { getAccountContextForLayout } from "@/lib/server/account";

export const dynamic = "force-dynamic";

export default async function ClassroomPage() {
  const account = await getAccountContextForLayout();
  const initialClassroom = account?.activeClassroom ?? account?.classrooms[0] ?? null;
  return <ClassroomView account={account} initialClassroom={initialClassroom} />;
}
