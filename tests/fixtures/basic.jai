#import "Basic";

Point :: struct {
    x: float;
    y: float;
}

Color :: enum {
    RED;
    GREEN;
}

add :: (a: int, b: int) -> int {
    return a + b;
}

main :: () {
    result := add(1, 2);
    print("Result: %\n", result);
}
