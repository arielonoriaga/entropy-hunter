import { charge } from "./payments";
import { log } from "./shared";

export function placeOrder(): void {
  log("placing");
  charge(100);
}
