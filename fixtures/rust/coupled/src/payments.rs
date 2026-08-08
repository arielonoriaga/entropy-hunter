use crate::orders::place_order;
use crate::shared::log;
use serde::Serialize;

pub fn charge(amount: u32) {
    log("charging");
    if amount == 0 {
        place_order(); // artificial cycle for testing
    }
}
