pub fn classify(n: i32, flag: bool) -> &'static str {
    if n > 100 && flag {
        "big-flagged"
    } else if n > 100 {
        "big"
    } else if n > 10 || flag {
        "medium"
    } else {
        "small"
    }
}

pub fn dispatch(code: u8) -> u8 {
    match code {
        0 => 1,
        1 => 2,
        2 => 4,
        3 => 8,
        _ => 0,
    }
}

pub fn scan(items: &[i32]) -> i32 {
    let mut total = 0;
    for item in items {
        if *item > 0 {
            total += item;
        }
        while total > 1000 {
            total /= 2;
        }
    }
    total
}
