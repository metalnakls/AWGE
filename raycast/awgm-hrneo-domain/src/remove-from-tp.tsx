import { removeSafariDomainFromTp } from "./domain-actions";

export default async function RemoveFromTp() {
  await removeSafariDomainFromTp();
}
