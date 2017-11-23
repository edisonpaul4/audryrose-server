const shippo = require('shippo')(process.env.SHIPPO_API_TOKEN);
const { OrdersController } = require('../orders/orders.controller');

exports.ShipmentsController = new class ShipmentsController {
  constructor() {
    this.baseAddress = {
      object_purpose: "PURCHASE",
      name: "Audry Rose",
      company: "",
      street1: "1515 7TH ST.",
      street2: "#433",
      city: "Santa Monica",
      state: "CA",
      zip: "90401",
      country: "US",
      phone: "+1 424 387 8000",
      email: "hello@loveaudryrose.com"
    }
  }

  getRatesForOrderShipment(parcelParams, orderId) {
    if (!parcelParams || !orderId)
      throw { message: 'Information of parcel and order\'s address is required.' };

    const parcel = {
      ...parcelParams,
      object_purpose: "QUOTE",
      distance_unit: "in",
      mass_unit: "oz",
    }

    const getCustomerAddress = orderId => {
      const prepareAddressObject = orderObject => ({
        name: orderObject.get('billing_address').name,
        street1: orderObject.get('billing_address').street_1,
        city: orderObject.get('billing_address').city,
        state: orderObject.get('billing_address').state,
        zip: orderObject.get('billing_address').zip,
        country: orderObject.get('billing_address').country_iso2,
        email: orderObject.get('billing_address').email
      });

      return OrdersController.getOrderById(orderId)
        .then(prepareAddressObject);
    };

    const createShipment = (addressTo, parcel, addressFrom) => {
      return shippo.shipment.create({
        "object_purpose": "QUOTE",
        "address_from": { ...addressFrom, object_purpose: "QUOTE" },
        "address_to": addressTo,
        "parcel": parcel,
        "async": true,
        "carrier_accounts": ["c67f85102205443e813814c72f2d48c6"]
      })
    }

    const minifyResponse = rates => rates.map(rate => ({
      carrier_account: rate.carrier_account,
      provider_image_200: rate.provider_image_200,
      provider: rate.provider,
      amount: rate.amount,
      currency: rate.currency,
      servicelevel_name: rate.servicelevel_name,
      days: rate.days,
      duration_terms: rate.duration_terms,
      attributes: rate.attributes,
    }));

    return getCustomerAddress(orderId)
      .then(customerAddress => createShipment(customerAddress, parcel, this.baseAddress))
      .then(shipmentObject => shippo.shipment.rates(shipmentObject.object_id))
      .then(response => minifyResponse(response.results))
      .then(rates => ({
        success: true,
        rates,
      }));
  }
}