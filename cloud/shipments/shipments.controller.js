const shippo = require('shippo')(process.env.SHIPPO_API_TOKEN);
const { OrdersController } = require('../orders/orders.controller');

exports.ShipmentsController = new class ShipmentsController {
  constructor() {
    this.baseAddress = {
      name: "Audry Rose",
      company: "",
      street1: "2665 Main Street",
      street2: "Suite B",
      city: "Santa Monica",
      state: "CA",
      zip: "90405",
      country: "US",
      phone: "+1 424 387 8000",
      email: "hello@loveaudryrose.com"
    };

    this.defaultUPSSmallBox = {
      length: "8.69",
      width: "5.44",
      height: "1.75",
      distance_unit: "in",
      weight: "3",
      mass_unit: "oz",
      template: "USPS_SmallFlatRateBox"
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

  shippoShipmentAddressFromOrder(orderObject) {
    return {
      name: orderObject.get('billing_address').first_name + ' ' + orderObject.get('billing_address').last_name,
      street1: orderObject.get('billing_address').street_1,
      city: orderObject.get('billing_address').city,
      state: orderObject.get('billing_address').state,
      zip: orderObject.get('billing_address').zip,
      country: orderObject.get('billing_address').country_iso2,
      email: orderObject.get('billing_address').email,
      phone: orderObject.get('billing_address').phone,
    }
  }
}