mod orders;
mod payments;
mod shared;

use crate::orders::place_order;

fn main() {
    place_order();
}
