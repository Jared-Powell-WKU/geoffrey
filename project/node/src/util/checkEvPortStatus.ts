import { Builder, By, until, WebDriver, WebElement } from 'selenium-webdriver';
import chrome, { Options as ChromeOptions, ServiceBuilder as ChromeServiceBuilder } from 'selenium-webdriver/chrome';
import * as chromedriver from 'chromedriver';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

export async function checkEvPortStatus(): Promise<boolean> {
  // Create a unique temp directory for Chrome user data
  const userDataDir = mkdtempSync(join(tmpdir(), 'chrome-user-data-'));

  // Headless Chrome options
  const options: ChromeOptions = new chrome.Options();
  options.addArguments('--headless', '--disable-gpu', '--no-sandbox');
  options.addArguments(`--user-data-dir=${userDataDir}`);

  // Use ServiceBuilder with explicit chromedriver path
  const serviceBuilder: ChromeServiceBuilder = new chrome.ServiceBuilder((chromedriver as any).path);

  const driver: WebDriver = await new Builder()
    .forBrowser('chrome')
    .setChromeOptions(options)
    .setChromeService(serviceBuilder)
    .build();

  try {
    await driver.get('https://driver.chargepoint.com/stations/812961');
 
    const xpathToWaitFor = '//*[@id="slideout_station_details"]/div[2]/div[3]/div[2]';
    await driver.wait(until.elementLocated(By.xpath(xpathToWaitFor)), 10000);

    const elements: WebElement[] = await driver.findElements(By.css('[data-qa-id="port_status_pill_available"]'));

    // const chargerOne: WebElement = await driver.findElement(By.xpath('//*[@id="slideout_station_details"]/div[2]/div[3]/div[2]/div/div/div[1]/div[1]/span'));
    // const qaId: string = await chargerOne.getAttribute("data-qa-id");

    // const chargerTwo: WebElement = await driver.findElement(By.xpath('//*[@id="slideout_station_details"]/div[2]/div[3]/div[2]/div/div/div[2]/div[1]/span'));
    // const qaIdTwo: string = await chargerTwo.getAttribute("data-qa-id");

    const isAvailable: boolean = elements.length > 0;
    console.log(isAvailable ? "Available" : "Not Available");
    return isAvailable;

  } catch (error) {
    console.error('Error checking port status:', error);
    return false;
  } finally {
    await driver.quit();
  }
}