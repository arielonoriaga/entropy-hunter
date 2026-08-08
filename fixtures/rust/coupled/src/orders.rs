use crate::payments::charge;
use crate::shared::log;

pub fn place_order() {
    log("placing");
    charge(100);
}
