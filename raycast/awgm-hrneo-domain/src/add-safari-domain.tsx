import { runSafariDomainAction } from "./domain-actions";

export default async function AddSafariDomain() {
  await runSafariDomainAction("add");
}
