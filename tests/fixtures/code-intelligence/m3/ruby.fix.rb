# Phase 1 TextMate extractor fixture - Ruby declarations.
# Plain test data; not meant to be a runnable program.

module Widgets
  class Widget
    attr_accessor :identifier, :label

    def initialize(identifier, label)
      @identifier = identifier
      @label = label
    end

    def describe
      "#{@identifier}:#{@label}"
    end

    def self.build(identifier, label)
      new(identifier, label)
    end
  end

  class FrozenWidget < Widget
  end

  def self.greet(widget)
    "hello #{widget.label}"
  end
end

def top_level_helper(name)
  "hi #{name}"
end
