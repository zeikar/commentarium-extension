export default function Header({ onClick }) {
  return (
    <div className="commentarium-header">
      <button className="commentarium-close-button" onClick={onClick}>
        <svg
          width="30px"
          height="30px"
          viewBox="0 0 20 20"
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
        >
          <path
            fill="#000000"
            fill-rule="evenodd"
            d="M2.293 15.293a1 1 0 101.414 1.414l6-6a1 1 0 000-1.414l-6-6a1 1 0 00-1.414 1.414L7.586 10l-5.293 5.293zm8 0a1 1 0 101.414 1.414l6-6a1 1 0 000-1.414l-6-6a1 1 0 10-1.414 1.414L15.586 10l-5.293 5.293z"
          />
        </svg>
      </button>
    </div>
  );
}
