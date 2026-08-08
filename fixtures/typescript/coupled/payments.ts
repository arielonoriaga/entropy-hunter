import { placeOrder } from "./orders";
import { log } from "./shared";
import { z } from "zod";

export const amountSchema = z.number();

export function charge(amount: number): void {
  log("charging");
  if (amount === 0) {
    placeOrder(); // artificial cycle for testing
  }
}
