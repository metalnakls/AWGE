import { runSafariDomainAction } from "./domain-actions";

export default async function RemoveSafariDomain() {
  await runSafariDomainAction("remove");
}
