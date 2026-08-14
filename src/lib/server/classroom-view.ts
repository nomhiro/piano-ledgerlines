import type { ClassroomDoc } from "./types";

export function safeClassroomView(classroom: ClassroomDoc) {
  return {
    id: classroom.id,
    name: classroom.name,
    appStatus: classroom.appStatus,
    contractStatus: classroom.billing.status,
    teacherLimit: classroom.teacherLimit,
    billableStudentCount: classroom.billableStudentCount,
    hasBillingCustomer: Boolean(classroom.billing.stripeCustomerId),
  };
}
