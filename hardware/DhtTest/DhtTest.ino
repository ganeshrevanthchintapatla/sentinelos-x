// Standalone DHT11 diagnostic for the UNO R4 WiFi. No Wi-Fi, no OLED.
// Reads the sensor on BOTH D2 and D3 so it does not matter which pin the data wire is on.
// Open Serial Monitor at 115200.
#include <DHT.h>

DHT dht2(2, DHT11);
DHT dht3(3, DHT11);

void report(const char* name, int pin, DHT& d) {
  pinMode(pin, INPUT_PULLUP);
  delay(5);
  int idle = digitalRead(pin);  // with the sensor wired, the data line idles HIGH
  float t = d.readTemperature();
  float h = d.readHumidity();
  Serial.print(name);
  Serial.print(" idle=");
  Serial.print(idle ? "HIGH" : "LOW");
  if (isnan(t) || isnan(h)) {
    Serial.println("  read FAILED");
  } else {
    Serial.print("  OK  ");
    Serial.print(t, 1);
    Serial.print("C  ");
    Serial.print(h, 0);
    Serial.println("%");
  }
}

void setup() {
  Serial.begin(115200);
  unsigned long t0 = millis();
  while (!Serial && millis() - t0 < 3000UL) {}
  dht2.begin();
  dht3.begin();
  Serial.println("DHT11 test: reading D2 and D3 every 2 s");
}

void loop() {
  report("D2", 2, dht2);
  report("D3", 3, dht3);
  Serial.println("--");
  delay(2000);
}
