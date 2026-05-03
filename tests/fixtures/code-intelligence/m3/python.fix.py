"""Phase 1 TextMate extractor fixture - Python declarations.

Plain test data; not meant to be a runnable program.
"""


def hello(name):
    return f"hi {name}"


async def fetch_remote():
    return []


def with_long_signature(
    first,
    second,
    third,
):
    return (first, second, third)


def decorator_factory(label):
    def actual_decorator(fn):
        return fn

    return actual_decorator


@decorator_factory("greeting")
def decorated(name):
    return name


class Account:
    def __init__(self, identifier):
        self.identifier = identifier

    def describe(self):
        return f"account-{self.identifier}"


class Frozen(Account):
    pass
