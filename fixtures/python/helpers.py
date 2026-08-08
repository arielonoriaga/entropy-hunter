def clamp(value):
    # keep values in a sane band
    if value > 50:
        return 50
    return value
