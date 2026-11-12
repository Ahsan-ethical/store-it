import { useState } from "react";

function App() {
  const [count, setCount] = useState(0);
  const [name, setName] = useState("");

  function handleClick() {
    setCount(count + 1);
  }

  function handleReset() {
    setCount(0);
  }

  function handleChange(e) {
    setName(e.target.value);
  }

  function handleKeyDown(e) {
    console.log("Key pressed:", e.key);
  }

  function handleMouseEnter() {
    console.log("Mouse entered!");
  }

  return (
    <div>
      <h1>React Events Playground</h1>

      <h2>Count: {count}</h2>

      {/* onClick */}
      <button onClick={handleClick}>
        Increase
      </button>

      {/* Another onClick */}
      <button onClick={handleReset}>
        Reset
      </button>

      <hr />

      {/* onChange */}
      <input
        type="text"
        value={name}
        onChange={handleChange}
        placeholder="Type your name"
      />

      <h2>Hello {name}</h2>

      <hr />

      {/* onMouseEnter */}
      <div
        onMouseEnter={handleMouseEnter}
        style={{
          padding: "30px",
          background: "lightgray",
          width: "200px"
        }}
      >
        Move your mouse here
      </div>

      <hr />

      {/* onKeyDown */}
      <input
        onKeyDown={handleKeyDown}
        placeholder="Press any key"
      />
    </div>
  );
}

export default App;