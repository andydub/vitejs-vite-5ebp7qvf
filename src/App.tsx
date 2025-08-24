import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export default function App() {
  const [mode, setMode] = useState("festejo");
  const [category, setCategory] = useState(null);
  const [eventoEnviado, setEventoEnviado] = useState(false);
  const [progreso, setProgreso] = useState(0.4);

  const isAsado = category === "Asado de amigos";

  const enviarEvento = () => setEventoEnviado(true);

  return (
    <main style={{ padding: 20 }}>
      <header style={{ display: "flex", justifyContent: "space-between", marginBottom: 30 }}>
        <h1>{mode === "festejo" ? "🎉 Yo festejo" : "🛠️ Yo laburo"}</h1>
        <button onClick={() => setMode(mode === "festejo" ? "laburo" : "festejo")}>🔁</button>
      </header>
      {eventoEnviado ? (
        <div>
          <h2>🎊 ¡Tu propuesta está en marcha!</h2>
          <div style={{ height: 20, background: "#444", borderRadius: 10, overflow: "hidden", margin: "20px 0" }}>
            <div style={{ width: `${progreso * 100}%`, background: "linear-gradient(to right, orange, gold, limegreen)", height: "100%" }}></div>
          </div>
          <p>Estado: {progreso < 1 ? "En propuesta" : "Confirmado"}</p>
          <button>Compartir por WhatsApp</button>
        </div>
      ) : (
        <div>
          {!category ? (
            <div>
              <h2>¿Qué estás armando?</h2>
              {["Asado de amigos", "Gran Fiesta", "Recital", "Jodita"].map((cat) => (
                <button key={cat} onClick={() => setCategory(cat)}>{cat}</button>
              ))}
            </div>
          ) : (
            <div>
              <h2>🎯 Organizando: {category}</h2>
              {!isAsado && (
                <>
                  <input placeholder="Fecha tentativa" />
                  <div>
                    {["$20.000", "$50.000", "$150.000", "$450.000"].map(m => (
                      <button key={m}>{m}</button>
                    ))}
                  </div>
                  <p>El cobro se realiza solo si se confirma el evento.</p>
                </>
              )}
              <input placeholder="Invitados (mail o WhatsApp)" />
              <button onClick={enviarEvento}>{isAsado ? "Enviar invitaciones" : "✨ Ver si se arma"}</button>
            </div>
          )}
        </div>
      )}
    </main>
  );
}
