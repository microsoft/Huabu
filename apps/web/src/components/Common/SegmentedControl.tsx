interface SegmentedControlProps<T extends string> {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}

export const SegmentedControl = <T extends string>({
  options,
  value,
  onChange,
}: SegmentedControlProps<T>) => {
  return (
    <div className="flex gap-2 rounded-md border border-gray-200 bg-white/90 p-1 shadow-sm backdrop-blur-sm">
      {options.map((option) => (
        <button
          key={option.value}
          onClick={() => onChange(option.value)}
          className={`cursor-pointer rounded border border-gray-200 px-3 py-1.5 text-sm transition-colors ${
            value === option.value
              ? 'bg-gray-100 font-semibold'
              : 'bg-white hover:bg-gray-50'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
};
