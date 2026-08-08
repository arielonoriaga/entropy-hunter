from helpers import clamp


def process(items):
    total = 0
    for item in items:
        if item > 0 and item < 100:
            total += clamp(item)
        elif item >= 100:
            total += 100
    return total
